# Local naming rules for Azure resources (alphanumeric sanitation)
locals {
  name_prefix          = "${var.app_name}-${var.environment}"
  resource_group_name  = "rg-${local.name_prefix}"
  storage_account_name = lower(replace("st${var.app_name}${var.environment}", "-", ""))
  acr_name             = lower(replace("acr${var.app_name}${var.environment}", "-", ""))
}

# 1. Azure Resource Group
resource "azurerm_resource_group" "main" {
  name     = local.resource_group_name
  location = var.azure_location

  tags = {
    Project     = "AI20K-RAV13"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
}

# 2. Azure Container Registry (ACR) — Basic SKU for MVP cost optimization ($5/mo)
resource "azurerm_container_registry" "acr" {
  name                = local.acr_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = var.acr_sku
  admin_enabled       = true

  tags = {
    Environment = var.environment
  }
}

# 3. Azure Storage Account & Azure File Share (Persistent Volume for SQLite & Rosbag files)
resource "azurerm_storage_account" "storage" {
  count                    = var.enable_persistent_storage ? 1 : 0
  name                     = substr(local.storage_account_name, 0, 24)
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  tags = {
    Environment = var.environment
  }
}

resource "azurerm_storage_share" "app_data" {
  count                = var.enable_persistent_storage ? 1 : 0
  name                 = "appdata"
  storage_account_name = azurerm_storage_account.storage[0].name
  quota                = 50
}

# 4. Azure Log Analytics Workspace
resource "azurerm_log_analytics_workspace" "logs" {
  name                = "log-${local.name_prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.environment == "production" ? 30 : 7
}

# 5. Azure Container Apps Environment
resource "azurerm_container_app_environment" "env" {
  name                       = "cae-${local.name_prefix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id
}

resource "azurerm_container_app_environment_storage" "env_storage" {
  count                        = var.enable_persistent_storage ? 1 : 0
  name                         = "appdatastorage"
  container_app_environment_id = azurerm_container_app_environment.env.id
  account_name                 = azurerm_storage_account.storage[0].name
  share_name                   = azurerm_storage_share.app_data[0].name
  access_key                   = azurerm_storage_account.storage[0].primary_access_key
  access_mode                  = "ReadWrite"
}

# 6. Azure Container App — Backend API Service (Scale to zero supported)
resource "azurerm_container_app" "backend" {
  name                         = "app-${local.name_prefix}-backend"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  secret {
    name  = "registry-password"
    value = azurerm_container_registry.acr.admin_password
  }

  registry {
    server               = azurerm_container_registry.acr.login_server
    username             = azurerm_container_registry.acr.admin_username
    password_secret_name = "registry-password"
  }

  ingress {
    external_enabled = true
    target_port      = var.backend_port
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "backend"
      image  = var.backend_container_image
      cpu    = var.cpu
      memory = var.memory

      env {
        name  = "APP_ENV"
        value = var.environment
      }
      env {
        name  = "APP_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "APP_PORT"
        value = tostring(var.backend_port)
      }
      env {
        name  = "CORS_ORIGINS"
        value = var.cors_origins
      }
      env {
        name  = "RUN_DB_PATH"
        value = "data/runs.db"
      }

      dynamic "volume_mounts" {
        for_each = var.enable_persistent_storage ? [1] : []
        content {
          name = "appdatastorage"
          path = "/app/data"
        }
      }
    }

    dynamic "volume" {
      for_each = var.enable_persistent_storage ? [1] : []
      content {
        name         = "appdatastorage"
        storage_name = azurerm_container_app_environment_storage.env_storage[0].name
        storage_type = "AzureFile"
      }
    }
  }
}

# 7. Azure Container App — Frontend Service (Scale to zero supported)
resource "azurerm_container_app" "frontend" {
  name                         = "app-${local.name_prefix}-frontend"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  secret {
    name  = "registry-password"
    value = azurerm_container_registry.acr.admin_password
  }

  registry {
    server               = azurerm_container_registry.acr.login_server
    username             = azurerm_container_registry.acr.admin_username
    password_secret_name = "registry-password"
  }

  ingress {
    external_enabled = true
    target_port      = var.frontend_port
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = "frontend"
      image  = var.frontend_container_image
      cpu    = var.cpu
      memory = var.memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "HOSTNAME"
        value = "0.0.0.0"
      }
      env {
        name  = "PORT"
        value = tostring(var.frontend_port)
      }
    }
  }
}
