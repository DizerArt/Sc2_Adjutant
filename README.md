# Sk2-Assistant

Sk2-Assistant is a project for a StarCraft II companion application. Its goal is to help a player keep structured information about opponents, matches, races, MMR, encounter history, notes, strategy patterns, build orders, and replay references.

The project is currently at the initial foundation stage. It does not contain a full application yet. The repository is organized so future work can move in two separate tracks: fast prototype experiments and stable application development.

## Target Users

The application is intended for StarCraft II players who want to prepare for future matches, remember recurring opponents, analyze previous encounters, and keep practical notes about race-specific strategies.

## Key Functions

- Store opponent profiles with race, nickname, current or last known MMR, and notes.
- Track match history and repeated encounters.
- Record strategy tags, build orders, and common opponent patterns.
- Link or describe replay references.
- Support pre-match preparation by showing relevant historical context.
- Support post-match review by adding notes, outcomes, and follow-up actions.

## Prototype vs Application

`01_prototype/` is for quick experiments. It can contain mock data, interface notes, and isolated sketches. Code here is allowed to be temporary and should not be treated as production architecture.

`02_application/` is for the stable application. Future production code, domain models, feature modules, tests, and deployment-related files should live there.

`03_project_context/` is for documentation and process memory. Future AI agents should read it before making significant changes.

## Project Structure

```text
.
├── 01_prototype/
│   ├── mock-data/
│   ├── ui-notes/
│   └── experiments/
├── 02_application/
│   ├── src/
│   │   ├── app/
│   │   ├── domain/
│   │   ├── features/
│   │   ├── shared/
│   │   └── infrastructure/
│   ├── public/
│   └── tests/
└── 03_project_context/
    └── docs/
```

## Running the Prototype

There is no runnable prototype yet. The first prototype should be created inside `01_prototype/` and should use `01_prototype/mock-data/opponents.sample.json` as starter data.

When a prototype stack is chosen, document the exact commands in `01_prototype/README.md`.

## Running the Main Application

There is no runnable main application yet. Future application code should be created inside `02_application/`.

When the MVP stack is finalized, document install, development, test, and build commands in `02_application/README.md`.

## Deployment

Deployment is not configured yet. The expected future path is:

- build a web version of the application;
- deploy it to Vercel, Netlify, or a VPS;
- optionally package a desktop version with Tauri or Electron;
- document environment variables and hosting-specific steps in `03_project_context/docs/004_deployment.md`.

## Documentation Process

Project documentation lives in `03_project_context/docs/`.

After each significant change:

- add a changelog entry in `03_project_context/docs/changelog/`;
- add an ADR in `03_project_context/docs/decisions/` for architectural decisions;
- add working notes in `03_project_context/docs/notes/` when useful.

## Instructions for Future AI Agents

Before continuing work:

1. Read this `README.md`.
2. Read `03_project_context/docs/000_project-overview.md`.
3. Read the latest changelog entry.
4. Read the latest ADR.
5. Keep prototype work separate from main application work.
6. Do not add production code, dependencies, or deployment infrastructure without documenting the decision.

