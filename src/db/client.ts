import { neon } from "@neondatabase/serverless";
import { getEnv } from "../config";

let _sql: ReturnType<typeof neon> | null = null;

export function getSql() {
  if (!_sql) {
    _sql = neon(getEnv().DATABASE_URL);
  }
  return _sql;
}
