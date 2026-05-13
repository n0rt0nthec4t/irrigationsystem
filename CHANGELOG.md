# Change Log

All notable changes to `irrigationsystem` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v0.0.3 (2026/05/13)

### Fixed
- Fixed disabled zones being able to start from stale HomeKit automation/config callback state after Web UI changes
- Fixed disabled running zones being unable to stop from the Web UI or HomeKit
- Fixed unexpected valve-open events for disabled zones leaving HomeKit state active instead of forcing the valve closed and returning idle
- Fixed Web UI zone disable changes so an already-running zone is stopped immediately when the updated config is applied

## v0.0.2 (2026/05/10)

### Added
- Added optional Web UI password support via `options.webUIBearerToken`
- Added a styled HomeKitUI authentication prompt with optional browser persistence

### Changed
- Updated irrigation system code for the latest `HomeKitDevice` API:
  - Uses `HomeKitDevice.LOGGER` instead of passing the logger through the device constructor
  - Uses `addService()` / `addCharacteristic()` helper names
  - Uses `removeService()` / `removeCharacteristic()` helper methods
- Improved HomeKitUI authentication flow:
  - Blocks the main UI until authentication succeeds
  - Shows a dedicated authentication-required screen if authentication is cancelled
  - Prevents duplicate auth prompts when multiple API requests fail at once
- Updated user-facing authentication wording from bearer token to Web UI password

### Fixed
- Fixed HomeKitUI config saves preserving an existing Web UI password when the masked password field is left unchanged
- Fixed HomeKitUI prompt submission behaviour for both button click and Enter key
- Fixed authenticated runtime polling and log streaming continuing after authentication is cancelled
- Fixed water-level history calls to use the newer `history()` options object

## v0.0.1 (2026/05/07)

- Initial non-alpha released version

## v0.0.1-alpha.9 (2026/05/05)

### Added
- Added interactive water usage dashboard:
  - Visual daily usage chart with support for 7, 14, and 30 day ranges
  - Tooltip support for per-day usage values
  - Summary metrics including total usage and daily average

- Added persistent dashboard UI state:
  - Selected usage range is now retained across page refresh
  - Aligns with existing collapse state persistence behaviour

### Changed
- Improved chart scaling and rendering:
  - Normalised bar height calculation for better visual distribution
  - Ensures consistent rendering across different usage ranges

- Refined 30-day chart layout:
  - Optimised spacing and bar sizing for dense datasets
  - Reduced visual clutter by hiding inline labels while retaining tooltips

- Improved frontend rendering stability:
  - Eliminated inconsistent dropdown behaviour caused by concurrent page refresh
  - Ensures immediate and reliable range switching after full page reload

- Improved UI consistency:
  - Fixed alignment and layout issues across different usage ranges
  - Ensured chart baseline and footer positioning remain consistent

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
