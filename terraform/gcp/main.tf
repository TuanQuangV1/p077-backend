locals {
  name_prefix = "${var.app_name}-${var.environment}"
  # GitHub Actions SA (from secrets.GCP_SERVICE_ACCOUNT). Requires pre-existing
  # compute.admin / storage.admin / serviceusage.admin to run terraform at all.
  github_sa_member = var.github_service_account != "" ? "serviceAccount:${var.github_service_account}" : null
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
}

# 4. GitHub Actions SA grants (idempotent when the email is passed in)
resource "google_project_iam_member" "github_artifact_writer" {
  count   = local.github_sa_member != null ? 1 : 0
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = local.github_sa_member
}

resource "google_project_iam_member" "github_ssh" {
  count   = local.github_sa_member != null ? 1 : 0
  project = var.project_id
  role    = "roles/compute.osLogin"
  member  = local.github_sa_member
}

resource "google_project_iam_member" "github_iap_tunnel" {
  count   = local.github_sa_member != null ? 1 : 0
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = local.github_sa_member
}

resource "google_project_iam_member" "iap_tunnel" {
  for_each = toset(var.iap_users)
  project  = var.project_id
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:${each.value}"
}

# 5. Firewall rules (default VPC)
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
