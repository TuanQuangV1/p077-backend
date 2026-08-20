output "external_ip" {
  description = "Public static IP of the deployment"
  value       = google_compute_address.ip.address
}

output "web_url" {
  description = "Public URL of the frontend"
  value       = "http://${google_compute_address.ip.address}"
}

output "health_url" {
  description = "Backend health check URL"
  value       = "http://${google_compute_address.ip.address}/health"
}

output "backend_image_uri" {
  description = "Artifact Registry image URI for backend"
  value       = google_artifact_registry_repository.backend.id
}

output "frontend_image_uri" {
  description = "Artifact Registry image URI for frontend"
  value       = google_artifact_registry_repository.frontend.id
}

output "vm_name" {
  description = "Compute Engine instance name"
  value       = google_compute_instance.vm.name
}
