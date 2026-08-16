terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # In production CI/CD, uncomment and configure S3 remote backend
  # backend "s3" {
  #   bucket         = "ai20k-terraform-state"
  #   key            = "environments/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "ai20k-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "AI20K-RAV13"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
