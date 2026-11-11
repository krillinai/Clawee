# Contributing Guide

**English** · [简体中文](../../CONTRIBUTING.md)

Start by reading the [README](../../README.md), [AGENTS.md](../../AGENTS.md), and [repository maintenance conventions](repository-maintenance.md).

AIGateway only maintains source code within this repository's responsibilities. PRs must describe the problem, behavioral changes, verification results, and cross-repository dependencies. Do not commit credentials, production configuration, data files, build caches, or installation packages. Use the pinned toolchain and run relevant tests and builds. Client builds or releases must pass `desktop:preflight:local`; server tests must use an isolated database.

Frequently used documents should be available in both Chinese and English and follow the [bilingual documentation guidelines](i18n.md). Update the English translation when changing the Chinese source, and run `python3 scripts/docs_i18n_check.py` before submitting documentation changes.

Ordinary PRs must not read release credentials. Prefer backward-compatible API changes and link the corresponding PR and verified versions from the other repository. Maintainers perform formal releases in a protected environment.
