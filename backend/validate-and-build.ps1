#!/usr/bin/env pwsh
# Run backend validation and build scripts

# Change to backend directory
set-location "D:\AI - Code Reviewer\backend"

# Run validation
Write-Host "Running Prisma validation..." -ForegroundColor Green
prisma validate

# Run typecheck
Write-Host "Running TypeScript typecheck..." -ForegroundColor Green
npm run typecheck

# Run tests
Write-Host "Running tests..." -ForegroundColor Green
npm test

# Run build
Write-Host "Running build..." -ForegroundColor Green
npm run build
