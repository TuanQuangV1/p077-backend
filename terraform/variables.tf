variable "azure_location" {
  description = "Azure datacenter location"
  type        = string
  default     = "eastus"
}

variable "environment" {
  description = "Deployment environment (staging or production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "app_name" {
  description = "Application name prefix"
  type        = string
  default     = "ai20krosbag"
}

variable "domain_name" {
  description = "Base domain name for deployment"
  type        = string
  default     = "example.com"
}

variable "backend_container_image" {
  description = "Docker image repository URI for backend"
  type        = string
  default     = "mcr.microsoft.com/azuredocs/aci-helloworld:latest"
}

variable "frontend_container_image" {
  description = "Docker image repository URI for frontend"
  type        = string
  default     = "mcr.microsoft.com/azuredocs/aci-helloworld:latest"
}

variable "backend_port" {
  description = "Backend container port"
  type        = number
  default     = 8000
}

variable "frontend_port" {
  description = "Frontend container port"
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "CPU cores for Container App (e.g. 0.25, 0.5, 1.0)"
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Memory for Container App (e.g. 0.5Gi, 1.0Gi, 2.0Gi)"
  type        = string
  default     = "1.0Gi"
}

variable "cors_origins" {
  description = "Allowed CORS origins comma-separated"
  type        = string
  default     = "http://localhost:3000"
}

variable "enable_persistent_storage" {
  description = "Enable Azure Storage File Share for SQLite and Rosbag persistent storage"
  type        = bool
  default     = true
}

variable "acr_sku" {
  description = "Azure Container Registry SKU (Basic for MVP/Demo cost optimization, Standard for production)"
  type        = string
  default     = "Basic"
}

variable "min_replicas" {
  description = "Minimum replicas for Azure Container App (0 enables scale-to-zero for max cost savings)"
  type        = number
  default     = 0
}

variable "max_replicas" {
  description = "Maximum replicas for Azure Container App"
  type        = number
  default     = 2
}
