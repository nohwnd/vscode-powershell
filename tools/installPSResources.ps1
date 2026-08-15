# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
param(
    [ValidateSet("PSGallery", "CFS")]
    [string]$PSRepository = "PSGallery"
)

# Install-PSResource can't use the project-scoped feed because OneBranch doesn't auth it
if ($PSRepository -eq "CFS" -and -not (Get-PSResourceRepository -Name CFS -ErrorAction SilentlyContinue)) {
    Register-PSResourceRepository -Name CFS -Uri "https://pkgs.dev.azure.com/powershell/PowerShell/_packaging/PowerShellGalleryMirror/nuget/v3/index.json"
}

# NOTE: Due to a bug in Install-PSResource with upstream feeds, we have to
# request an exact version. Otherwise, if a newer version is available in the
# upstream feed, it will fail to install any version at all.
Install-PSResource -Verbose -TrustRepository -RequiredResource  @{
    InvokeBuild = @{
        version = "5.14.23"
        repository = $PSRepository
      }
    platyPS = @{
        version = "0.14.2"
        repository = $PSRepository
    }
    Pester = @{
        version = "5.7.1"
        repository = $PSRepository
    }
}

# The end-to-end Test Explorer suite needs Pester 6.1.0 or newer for the
# BeforeContainer feature. Installed side by side with 5.7.1 rather than
# replacing it: the runner picks the newest installed Pester that is at least
# 5.0, and keeping 5.7.1 around leaves the older line available.
Install-PSResource -Verbose -TrustRepository -RequiredResource @{
    Pester = @{
        version = "6.1.0"
        repository = $PSRepository
    }
}
