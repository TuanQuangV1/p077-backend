variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "ai20k-p077"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "asia-southeast1"
}

variable "zone" {
  description = "GCP zone for Compute Engine instances"
  type        = string
  default     = "asia-southeast1-a"
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
  description = "Application name prefix for resource naming"
  type        = string
  default     = "ai20k-p077"
}

variable "domain_name" {
  description = "Public domain for the deployment (empty = HTTP-only on static IP, no TLS)"
  type        = string
  default     = ""
}

variable "machine_type" {
  description = "Compute Engine machine type"
  type        = string
  default     = "e2-small"
}

variable "boot_disk_size" {
  description = "Boot disk size in GB"
  type        = number
  default     = 30
}

variable "data_disk_size" {
  description = "Persistent data disk size in GB (SQLite + rosbag files, mounted at /opt/app/data)"
  type        = number
  default     = 50
}

variable "backend_image" {
  description = "Artifact Registry image URI for backend (e.g. asia-docker.pkg.dev/PROJECT/backend:TAG)"
  type        = string
  default     = "asia-docker.pkg.dev/ai20k-p077/backend:latest"
}

variable "frontend_image" {
  description = "Artifact Registry image URI for frontend (e.g. asia-docker.pkg.dev/PROJECT/frontend:TAG)"
  type        = string
  default     = "asia-docker.pkg.dev/ai20k-p077/frontend:latest"
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

variable "cors_origins" {
  description = "Allowed CORS origins comma-separated"
  type        = string
  default     = "http://localhost:3000"
}

variable "ssh_source_ranges" {
  description = "CIDR ranges allowed to SSH into the VM. Default is GCP IAP range (35.235.240.0/20)."
  type        = list(string)
  default     = ["35.235.240.0/20"]
}

variable "iap_users" {
  description = "Email addresses granted IAP tunnel access for SSH (roles/iap.tunnelResourceAccessor)."
  type        = list(string)
  default     = []
}

variable "github_service_account" {
  description = "Email of the GitHub Actions workload identity service account (from secrets.GCP_SERVICE_ACCOUNT). Grants Artifact Registry write + SSH access."
  type        = string
  default     = ""
}
