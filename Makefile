# Lepimemory 开发 / 演示脚手架 — 草案 v0.2（2026-09-28，待评审）
# ------------------------------------------------------------------
# make dev     起 Hindsight（等健康检查）→ 前台启动 dsh Web UI
# make stop    停 Hindsight（保留容器与数据）
# make clean   删除 Hindsight 容器（保留 PG 卷与 DSH_HOME）
# make reset   全量重置：删 PG 卷 + 删 DSH_HOME（下次 make dev 从零开始）
#
# 注意：
# - 需要 Docker Compose v2（`docker compose`；本机已装 v5.5.1）
#   默认不强制拉新镜像（避免误换正在运行的容器）；需要最新镜像时先 `docker compose pull`
# - dsh 锁版本 0.1.7-rc.2；本机（nixpkgs Node 会让 dsh 启动崩）改用封装好的 CLI：
#       make dev DSH=dsh
# - 启动前自动 source ./.env（把 key 传给 dsh；compose 自己也会读 .env）
# - dsh 状态目录默认 = 仓库内 .dsh/（已 gitignore，可一键重置）
# - 正确启动写法是 `--profile lepimemory`；`dsh web --profile X` 会报
#   "select a profile only once"
# ------------------------------------------------------------------

SHELL := /bin/bash
DSH_HOME ?= $(CURDIR)/.dsh
PORT ?= 3080
DSH ?= npx -y @deepseek-ai/dsh@0.1.7-rc.2

.PHONY: dev install-profile stop clean reset

## dev: 一键启动（Hindsight 后台 + dsh 前台；Ctrl-C 退出 dsh）
dev: install-profile
	docker compose up -d --wait
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; $(DSH) --profile lepimemory --no-open --port $(PORT)

## install-profile: 把仓库里的 profile 同步进 DSH_HOME（幂等），并物化插件依赖
install-profile:
	mkdir -p $(DSH_HOME)/profiles/lepimemory
	cp -Rf dsh/profiles/lepimemory/. $(DSH_HOME)/profiles/lepimemory/
	DSH_HOME=$(DSH_HOME) $(DSH) plugin --profile lepimemory install

## stop: 停掉 Hindsight（保留数据）
stop:
	docker compose stop

## clean: 移除 Hindsight 容器（保留 PG 卷与 DSH_HOME）
clean:
	docker compose down

## reset: 全量重置（删 PG 卷 + DSH_HOME）——状态归零
reset:
	docker compose down -v
	rm -rf $(DSH_HOME)
