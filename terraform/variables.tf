variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1"
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
  default     = "ai20k-rosbag"
}

variable "domain_name" {
  description = "Base domain name for deployment"
  type        = string
  default     = "example.com"
}

variable "backend_container_image" {
  description = "Docker image repository URI for backend"
  type        = string
  default     = "ai20k-rosbag-backend:latest"
}

variable "frontend_container_image" {
  description = "Docker image repository URI for frontend"
  type        = string
  default     = "ai20k-rosbag-frontend:latest"
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

variable "desired_count" {
  description = "Number of ECS task instances to run"
  type        = number
  default     = 1
}

variable "cpu" {
  description = "CPU units for ECS task (e.g. 512 = 0.5 vCPU, 1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "memory" {
  description = "Memory (MB) for ECS task (e.g. 1024 = 1GB, 2048 = 2GB)"
  type        = number
  default     = 1024
}

variable "cors_origins" {
  description = "Allowed CORS origins comma-separated"
  type        = string
  default     = "http://localhost:3000"
}

variable "enable_efs_persistence" {
  description = "Enable AWS EFS persistent volume for SQLite and Rosbag uploads"
  type        = bool
  default     = true
}
