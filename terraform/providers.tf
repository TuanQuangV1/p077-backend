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
  # subscription_id is read from the ARM_SUBSCRIPTION_ID environment variable
  # (set via GitHub Secret AZURE_SUBSCRIPTION_ID in CI/CD workflows).
  # Do not hardcode the subscription ID here.

  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}
