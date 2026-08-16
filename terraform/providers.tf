terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
  }

  # In production CI/CD, configure Azure Blob Storage remote backend
  # backend "azurerm" {
  #   resource_group_name  = "rg-ai20k-tfstate"
  #   storage_account_name = "stai20ktfstate"
  #   container_name       = "tfstate"
  #   key                  = "terraform.tfstate"
  # }
}

provider "azurerm" {
  subscription_id = "bea3db28-8916-4dc6-928c-8fcd12742c3a"

  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}
