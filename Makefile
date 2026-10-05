# All default runtime commands use the verified repository-local toolchain.
SHELL := /bin/bash
override NODE := $(CURDIR)/.runtime/bin/node
export PATH := $(CURDIR)/.runtime/bin:$(PATH)

# Only explicit make/environment values override the optional .env file.
ifneq ($(origin DSH_HOME),undefined)
export DSH_HOME
endif
ifneq ($(origin PORT),undefined)
export PORT
endif

.PHONY: bootstrap install-profile dev verify stop clean reset

bootstrap:
	bash scripts/bootstrap-runtime.sh

install-profile:
	$(NODE) scripts/runtime.mjs install

dev:
	$(NODE) scripts/runtime.mjs dev

verify:
	$(NODE) scripts/runtime.mjs verify

# These maintenance commands do not reset data unless reset is explicitly used.
stop:
	docker compose stop

clean:
	docker compose down

reset:
	docker compose down -v
	rm -rf -- "$(if $(DSH_HOME),$(DSH_HOME),$(CURDIR)/.dsh)"
