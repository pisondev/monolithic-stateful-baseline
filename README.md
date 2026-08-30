# Monolithic Stateful Baseline

Assignment 1 for **PACS262521 Pengembangan Perangkat Lunak Scalable**, S1 Ilmu Komputer,
Universitas Gadjah Mada.

**Author:** Pison Golda Mountera (24/543770/PA/23107)

A deliberately monolithic and stateful web application: one server-side script, one process,
session state in local RAM, and a database file on the same host. Every one of those is a
constraint of the assignment rather than an oversight. The point is to build the
architecture that does *not* scale horizontally, measure it honestly, and keep it as the
baseline that later work in this course refactors against.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 LTS, standard library only |
| HTTP | `node:http`, no framework |
| Database | SQLite through the built-in `node:sqlite`, local file |
| Sessions | In-process `Map`, opaque identifier in an `HttpOnly` cookie |
| Frontend | Hand-written HTML, CSS and JavaScript, `fetch()` only |

Runtime dependencies: **none**. `package.json` declares an empty `dependencies` object, and
that is deliberate: the assignment bans frameworks that abstract session management away,
so nothing is installed that could.

## Requirements

Node.js 22.5 or newer, below 23. `node:sqlite` is built in from 22.5 but still requires the
`--experimental-sqlite` flag, which the npm scripts pass for you. Node 23 and later drop the
flag and would reject it.

## Running

```
npm start        # serves on http://localhost:8080
npm test
```

`PORT` overrides the listen port.

## Status

Scaffolding. The server, frontend, test suite, API reference and EC2 deployment runbook
land as the implementation progresses.
