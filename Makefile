.PHONY: up down logs ps restart check psql nats-sub

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

restart:
	docker compose restart

check:
	npx tsx scripts/check-infra.ts

psql:
	psql 'postgresql://syncra:syncra@localhost:6432/syncra'

nats-sub:
	docker compose exec -e NATS_URL=nats://nats:4222 nats-box nats sub ">"

nats-pub:
	@test -n "$(SUBJECT)" || (echo "usage: make nats-pub SUBJECT=task.created MSG='{\"id\":1}'"; exit 1)
	docker compose exec -e NATS_URL=nats://nats:4222 nats-box nats pub "$(SUBJECT)" "$(MSG)"

migrate:
	npm run db:migrate

db-reset:
	npm run db:reset
