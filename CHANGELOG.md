# Change Log
All notable changes to Org Everywhere will be documented in this file.

## [Unreleased]
### Added
- Org: Set Up a Local orgs Server: downloads the latest orgs release for this
  machine (checked against its checksums), configures it for a folder of org
  files with a login of its own, starts it and connects. Start, Stop, Restart,
  Update, Edit Config and Show Log commands; it starts with VS Code
  (`org.orgsServer.autoStart`) and new releases are offered once a day
  (`org.orgsServer.checkForUpdates`)
- Org: Read the orgs Docs: the orgs manual (docs/docs.html from the orgs
  repository) in a webview, following the VS Code theme; the last copy is
  kept for reading offline

## [1.0.0] - 2026-10-11
The first release of Org Everywhere, a fork of vscode-org-mode built around
the [orgs server](https://github.com/ihdavids/orgs).

### Added
- The agenda and Clock views, clocking, quick capture, refile/archive, table
  formulas, running code, exporting, habits, encryption, attachments, file
  history and search, through the orgs server
- Table editing, plotting and the column view; links, backlinks and
  completion; footnotes; narrowing; previews (web, slides, Gantt, mind map)
- The command menu (Ctrl+Alt+O M), the walkthrough, and the manual in docs/

### Changed
- Renamed from IOrg / vscode-org-mode to Org Everywhere
  (`iorg.vscode-org-everywhere`)
- Bundled with esbuild: the .vsix carries one file and no node_modules

### Fixed
- Alt+Left / Alt+Right on a timestamp no longer eats the space before it

# vscode-org-mode history
The changes below are from the original vscode-org-mode.

## [1.0.0]
### Added
- folding
- source block coloration (#+BEGIN_SRC)
- outline view
- e2e automated tests
- code coverage

## [0.5.0]
### Added
- clock in/clock out function courtesy of @BoredMai
  - org.clockin &rarr; ctrl+alt+o | ctrl+i
  - org.clockout &rarr; ctrl+alt+o | ctrl+o
  - org.updateclock &rarr; ctrl+alt+o | ctrl+u
### Changed
- comment and link pattern matching updated by @chaseadamsio
- fix for insert region of block snippets also courtesy of @chaseadamsio

*Apologies for the odd version jump, it was assumed that "vsce publish minor" would follow the version numbering already established in some way. It didnt.*

## [0.1.3] - 2017-05-27
### Changed
- Stop auto-closing single quotes
- Complete metamorphosis

## [0.1.2] - 2017-04-14
### Changed
- Fix issue #53
- Attempt fix for issue #62
- Change description

## [0.1.1] - 2017-04-10
### Added
- Add screenshots to README
### Changed
- Fix issue #55
- Set extension category to "Languages"

## [0.1.0] - 2017-04-08
- Initial release
