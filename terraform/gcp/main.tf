locals {
  name_prefix     = "${var.app_name}-${var.environment}"
  github_sa_email = "github-actions@${var.project_id}.iam.gserviceaccount.com"
  backend_image   = var.backend_image != "" ? var.backend_image : "${var.region}-docker.pkg.dev/${var.project_id}/backend:latest"
  frontend_image  = var.frontend_image != "" ? var.frontend_image : "${var.region}-docker.pkg.dev/${var.project_id}/frontend:latest"
}

# 1. Enable required GCP APIs
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifact_registry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iam" {
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

# Required for reading/writing the project IAM policy (google_project_iam_member).
# Without it every project-level IAM resource fails with SERVICE_DISABLED.
resource "google_project_service" "cloud_resource_manager" {
  service            = "cloudresourcemanager.googleapis.com"
  disable_on_destroy = false
}

# 2. Artifact Registry repositories (backend + frontend)
resource "google_artifact_registry_repository" "backend" {
  depends_on    = [google_project_service.artifact_registry]
  location      = var.region
  project       = var.project_id
  repository_id = "backend"
  description   = "AI20K ${var.environment} backend Docker images"
  format        = "DOCKER"
}

resource "google_artifact_registry_repository" "frontend" {
  depends_on    = [google_project_service.artifact_registry]
  location      = var.region
  project       = var.project_id
  repository_id = "frontend"
  description   = "AI20K ${var.environment} frontend Docker images"
  format        = "DOCKER"
}

# 3. VM service account (pulls images from Artifact Registry)
resource "google_service_account" "vm" {
  account_id   = "vm-${var.app_name}-${var.environment}"
  display_name = "AI20K ${var.environment} VM service account"
}

resource "google_project_iam_member" "vm_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.vm.email}"

  depends_on = [google_project_service.cloud_resource_manager]
}

# 4. GitHub Actions SA IAM grants.
# The SA is provisioned out-of-band with Workload Identity Federation; its
# email is constructed here so no iam.serviceAccounts.get permission is
# needed at plan time. Existence verified once via:
#   gcloud iam service-accounts list --project=ai20k-p077
resource "google_project_iam_member" "github_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${local.github_sa_email}"

  depends_on = [google_project_service.cloud_resource_manager]
}

resource "google_project_iam_member" "github_ssh" {
  project = var.project_id
  role    = "roles/compute.osLogin"
  member  = "serviceAccount:${local.github_sa_email}"

  depends_on = [google_project_service.cloud_resource_manager]
}

resource "google_project_iam_member" "github_iap_tunnel" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "serviceAccount:${local.github_sa_email}"

  depends_on = [google_project_service.cloud_resource_manager]
}

# State bucket is provisioned out-of-band (see the workflow bootstrap step);
# only its IAM binding is managed here. Do NOT move google_storage_bucket
# into this config — the state lives inside the bucket itself.
# objectAdmin scoped to this single bucket is the minimum the GCS backend
# needs; grant targets the CI-only WIF service account.
#trivy:ignore:AVD-GCP-0007
resource "google_storage_bucket_iam_member" "github_tfstate" {
  bucket = "tfstate-ai20k-p077-gcp"
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.github_sa_email}"
}

resource "google_project_iam_member" "iap_tunnel" {
  for_each = toset(var.iap_users)
  project  = var.project_id
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:${each.value}"

  depends_on = [google_project_service.cloud_resource_manager]
}

# 5. Firewall rules (default VPC)
# NOTE: 80/443 are open to the whole internet. That is expected for a public web
# app, but it means the instance is directly exposed — before this stack backs a
# real deployment, put it behind a CDN/WAF (Cloudflare, GCLB + Cloud Armor) and
# restrict source_ranges to the load balancer's ranges. Tracked in
# plan_final.md as deferred item #19.
resource "google_compute_firewall" "http" {
  name    = "${local.name_prefix}-http"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${local.name_prefix}-http"]
}

resource "google_compute_firewall" "ssh" {
  name    = "${local.name_prefix}-ssh"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = var.ssh_source_ranges
  target_tags   = ["${local.name_prefix}-ssh"]
}

# 6. Static external IP
resource "google_compute_address" "ip" {
  name   = "${local.name_prefix}-ip"
  region = var.region
}

# 7. Persistent data disk (SQLite + rosbag files survive redeploys)
resource "google_compute_disk" "data" {
  name = "${local.name_prefix}-data"
  type = "pd-standard"
  zone = var.zone
  size = var.data_disk_size
}

# 8. Compute Engine instance running the full docker-compose stack
resource "google_compute_instance" "vm" {
  name         = local.name_prefix
  machine_type = var.machine_type
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = "debian-12"
      size  = var.boot_disk_size
      type  = "pd-standard"
    }
  }

  attached_disk {
    source = google_compute_disk.data.id
  }

  metadata_startup_script = templatefile("${path.module}/templates/startup.sh.tpl", {
    data_disk_name = google_compute_disk.data.name
  })

  network_interface {
    network    = "default"
    subnetwork = "default"

    # VM must be reachable over HTTP/HTTPS for end users;
    # SSH access is separately restricted to IAP range (see google_compute_firewall.ssh).
    #trivy:ignore:AVD-GCP-0031
    access_config {
      nat_ip       = google_compute_address.ip.address
      network_tier = "PREMIUM"
    }
  }

  tags = ["${local.name_prefix}-http", "${local.name_prefix}-ssh"]

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    APP_ENV        = var.environment
    enable-oslogin = "TRUE"
  }
}
