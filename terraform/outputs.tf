output "resource_group_name" {
  description = "Azure Resource Group name"
  value       = azurerm_resource_group.main.name
}

output "acr_login_server" {
  description = "Azure Container Registry login server host"
  value       = azurerm_container_registry.acr.login_server
}

output "backend_container_app_fqdn" {
  description = "Public Fully Qualified Domain Name of Backend Container App"
  value       = azurerm_container_app.backend.ingress[0].fqdn
}

output "frontend_container_app_fqdn" {
  description = "Public Fully Qualified Domain Name of Frontend Container App"
  value       = azurerm_container_app.frontend.ingress[0].fqdn
}

output "environment" {
  description = "Current deployment environment"
  value       = var.environment
}
