# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.0.0 - 2026-07-06

### Added
- Patient registration and login with email verification (ENG-42)
- Professional registration with license number pending manual validation (ENG-43)
- Docker Compose setup with PostgreSQL 15 for local integration tests (ENG-39)
- GitHub Actions workflow running integration tests against a service container (ENG-39)
- Automatic Prisma schema sync before each integration suite (ENG-39)

### Changed
- Prisma client generator switched to prisma-client-js for CommonJS compatibility (ENG-39)