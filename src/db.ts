// One shared Postgres connection pool for the whole app (CLI, API, worker)
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });