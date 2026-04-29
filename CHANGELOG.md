# Change Log

All notable changes to `irrigationsystem` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v0.0.1-alpha.4 (2026/04/30)

### Added
- Added HomeKitUI integration for standalone irrigation system management
- Added Dashboard page with visual water tank level indicators
- Added per-tank rendering with capacity, percentage, and calculated litres
- Added self-contained HTML/CSS rendering support for custom UI pages
- Added last-updated tracking for tank level readings

### Changed
- Refactored system to expose runtime data via `onGetPage` instead of embedding UI logic
- Improved separation between HomeKitUI (generic) and project-specific rendering
- Updated startup logging to include HomeKitUI setup and configured pages
- Improved tank rendering layout to match HomeKit pairing-style cards

### Fixed
- Fixed dashboard refresh behaviour resetting to default page (added hash-based navigation support)

## v0.0.1 (alpha)

- General code cleanup and bug fixes

## Known Issues

- When configured with seperate virtual power switch and/or leak sensor and accessories are shown as one tile in HomeKit, extra valves are displayed with blank names. Think this is a HomeKit bug, but need to look into further