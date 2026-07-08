<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Integration tests (PostgreSQL 15 via Docker)

Integration tests run against a real PostgreSQL 15 instance instead of Supabase,
so the results reflect actual database behavior. The database is provided by
[`docker-compose.yml`](./docker-compose.yml) locally, and by a GitHub Actions
`services:` container in CI — both are driven by the same
[`scripts/test-integration.sh`](./scripts/test-integration.sh) script, which
applies the Prisma schema (`prisma db push`) before running the suite.

Test files for this suite use the `*.integration.spec.ts` suffix (see
[`test/jest-integration.json`](./test/jest-integration.json)), separate from
unit tests (`pnpm run test`) and e2e tests (`pnpm run test:e2e`).

### Dev Container (recommended)

Opening the repo in the [dev container](./.devcontainer/devcontainer.json) starts
everything automatically: `docker-compose.yml` defines an `app` service (the
container VS Code attaches to) alongside `postgres-test`, wired together via
`depends_on`/healthcheck so `postgres-test` is ready before `app` starts. Inside
the dev container, `DATABASE_URL` already points at `postgres-test:5432` (the
Compose network hostname — not `localhost`, which only works for processes
running on the host), and `postStartCommand` runs `prisma db push` on every
start. Once it's up, just run:

```bash
$ pnpm run test:integration
```

`SKIP_DOCKER=true` is set inside the dev container, so the script skips trying
to run `docker compose up` from within the `app` container (no Docker CLI in
there) — `postgres-test` is already running as a sibling service.

### Requirements (without the Dev Container)

- Docker and Docker Compose v2 installed locally.

### Usage

```bash
# start the test database (postgres:15, healthcheck via pg_isready)
$ pnpm run db:test:up

# apply the Prisma schema and run the integration suite
$ pnpm run test:integration

# stop the test database (keeps the data volume)
$ pnpm run db:test:down

# stop the test database and wipe its data volume
$ pnpm run db:test:reset
```

`pnpm run test:integration` starts the database automatically if it isn't
running yet, so `pnpm run db:test:up` is optional — it's just handy to keep
the database up between test runs during local development.

### Environment variables

The test database defaults (see [`docker-compose.yml`](./docker-compose.yml)
and [`scripts/test-integration.sh`](./scripts/test-integration.sh)) work out
of the box with no configuration. To override them, set these in your `.env`
(see [`.env.example`](./.env.example)):

| Variable                 | Default                                                                      | Description                     |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------- |
| `POSTGRES_TEST_USER`     | `mediconnect`                                                                | Test DB user                     |
| `POSTGRES_TEST_PASSWORD` | `mediconnect`                                                                | Test DB password                 |
| `POSTGRES_TEST_DB`       | `mediconnect_test`                                                           | Test DB name                     |
| `POSTGRES_TEST_PORT`     | `5433`                                                                       | Host port mapped to the container |
| `DATABASE_URL`           | `postgresql://mediconnect:mediconnect@localhost:5433/mediconnect_test?schema=public` | Full connection string used by Prisma and Jest during `test:integration` |

In CI (see [`.github/workflows/integration-tests.yml`](./.github/workflows/integration-tests.yml)),
PostgreSQL 15 runs as a `services:` container instead of via Docker Compose,
and `DATABASE_URL` points at that container.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
