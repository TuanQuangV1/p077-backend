terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.30"
    }
  }

  # Remote state in a GCS bucket. The bucket is bootstrapped idempotently by
  # the GitHub Actions workflow (.github/workflows/gcp-deploy.yml) before
  # `terraform init`.
  backend "gcs" {
    bucket = "tfstate-ai20k-p077-gcp"
    prefix = "terraform-gcp"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
