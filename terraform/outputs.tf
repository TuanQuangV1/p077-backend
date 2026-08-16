output "alb_dns_name" {
  description = "Public DNS address of the Load Balancer"
  value       = aws_lb.main.dns_name
}

output "ecr_backend_repository_url" {
  description = "URL of the ECR repository for backend Docker image"
  value       = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_repository_url" {
  description = "URL of the ECR repository for frontend Docker image"
  value       = aws_ecr_repository.frontend.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "environment" {
  description = "Current deployment environment"
  value       = var.environment
}
