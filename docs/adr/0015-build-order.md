# 0015. Build order: foundation to learning, PortfolioV7 first
Status: accepted (2026-11-15)
## Context
The workflow has many parts that depend on each other. Building all of them at once would delay any real use and hide integration problems.
## Decision
foundation → setup → verify → review → ship → driver → learning. First real target: PortfolioV7.
## Alternatives considered
- Build the driver first (no tested phases underneath it).
- Build all phases in parallel (integration problems surface late).
## Consequences
- Each phase is usable before the driver exists.
- PortfolioV7 is the first test of the whole workflow.
