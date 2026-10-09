# All default runtime commands use the verified repository-local toolchain.
SHELL := /bin/bash
override NODE := $(CURDIR)/.runtime/bin/node
override PNPM := $(CURDIR)/.runtime/bin/pnpm
export PATH := $(CURDIR)/.runtime/bin:$(PATH)

# Only explicit make/environment values override the optional .env file.
ifneq ($(origin DSH_HOME),undefined)
export DSH_HOME
endif
ifneq ($(origin PORT),undefined)
export PORT
endif

.PHONY: bootstrap build install-profile dev verify typecheck lint format-check check stop clean reset

bootstrap:
	bash scripts/bootstrap-runtime.sh

# Compile hand-written sources into generated artifacts (lib/, scripts/dist/, client.js).
build:
	$(NODE) scripts/build.mts

# --install additionally materialises the frozen lock before building.
install-profile:
	$(NODE) scripts/build.mts --install
	$(NODE) scripts/dist/runtime.js install

dev: build
	$(NODE) scripts/dist/runtime.js dev

verify: build
	$(NODE) scripts/dist/runtime.js verify

typecheck:
	$(NODE) scripts/build.mts --typecheck

lint:
	$(PNPM) lint

format-check:
	$(PNPM) format:check

# Full gate: runtime verification, then static checks.
check:
	$(MAKE) verify
	$(MAKE) lint
	$(MAKE) format-check

# These maintenance commands do not reset data unless reset is explicitly used.
stop:
	docker compose stop

clean:
	docker compose down

reset:
	docker compose down -v
	rm -rf -- "$(if $(DSH_HOME),$(DSH_HOME),$(CURDIR)/.dsh)"
