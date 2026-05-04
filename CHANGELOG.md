# Change Log

All notable changes to `irrigationsystem` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v0.0.1-alpha.7 (2026/05/04)

### Added
- Added post-run flow grace period handling:
  - Residual water flow immediately after a zone stops is now treated as expected
  - Prevents false leak indication and incorrect dashboard alerts during normal shutdown

- Enhanced zone completion logging:
  - Logs now include total runtime and water usage per run
  - Improves visibility and debugging of irrigation activity

### Changed
- Refined dashboard flow state logic:
  - Flow is now considered expected when a zone is active OR within the post-close grace window
  - Water usage and flow indicators now better reflect real-world system behaviour

- Improved unassigned water tracking:
  - Residual flow after normal zone shutdown is no longer counted as unassigned usage
  - More accurate leak/manual flow detection

### Fixed
- Fixed dashboard showing false “unexpected flow” (red) after normal zone completion
- Fixed water usage incorrectly accumulating after zone stop due to residual pressure flow
- Fixed flow and water usage indicators turning red during expected shutdown conditions

## v0.0.1-alpha.6 (2026/05/02)

### Added
- Added dynamic HomeKit zone handling:
  - Zones are now created, updated, and removed at runtime without requiring restart
  - Supports relay layout changes with safe valve reinitialisation
- Added stable HomeKit service identity using UUID-derived subtype (CRC32) instead of index
- Added runtime configuration snapshot tracking per zone for change detection
- Added virtual system power control support (UI + backend integration)

### Changed
- Refactored zone setup logic (`#setupZones`) to be fully idempotent and dynamic
- Replaced index-based service mapping with UUID-based mapping to prevent service reordering issues
- Zone configuration updates now only rebuild valves when relay configuration changes
- Improved HomeKit characteristic updates to avoid unnecessary writes and preserve state
- Improved zone naming handling with early exit when no change is detected

### Fixed
- Fixed HomeKit service reordering causing incorrect zone grouping and control issues
- Fixed unstable `Identifier` updates that could break HomeKit service consistency
- Fixed zones appearing as blank/unresponsive when accessory grouping changed
- Fixed virtual power switch interfering with irrigation service grouping in Home app
- Fixed inconsistent zone naming display in HomeKit (now reflects configured zone names correctly)

## v0.0.1-alpha.5 (2026/04/30)

### Added
- Added explicit zone start logging when runs are initiated via HomeKit (`setZoneActive`)
- Added fallback safety cleanup when valves fail to emit close events during stop

### Changed
- Refined multi-valve sequencing logic to ensure seamless transitions (open next valve before closing previous)
- Improved valve state synchronisation to prevent false run termination during relay switching
- Updated zone timing logic to use consistent millisecond-based runtime calculations

### Fixed
- Fixed missing "zone turned on" log for timed runs (run now created before valve open event)
- Fixed missing "zone turned off" log when final valve closes
- Fixed valve close detection incorrectly ignoring final close event due to stale `isOpen()` state
- Fixed negative duration calculation in valve runtime logging (mixed ms/seconds)
- Fixed inconsistent timestamp handling between Valve and IrrigationSystem modules

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