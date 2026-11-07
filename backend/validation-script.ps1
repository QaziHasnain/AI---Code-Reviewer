# PowerShell script to validate and build the backend project

# Change to the backend directory
set-location "D:\AI - Code Reviewer\backend"

# Run Prisma validation
Write-Host "Running Prisma validation..." -ForegroundColor Green
prisma validate

# Run TypeScript typecheck
Write-Host "Running TypeScript typecheck..." -ForegroundColor Green
npm run typecheck

# Run tests
Write-Host "Running tests..." -ForegroundColor Green
npm test

# Run build
Write-Host "Running build..." -ForegroundColor Green
npm run build
