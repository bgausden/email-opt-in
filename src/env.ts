// eslint-disable-next-line no-unused-vars
import tsdotenv from 'ts-dotenv';

export type Env = tsdotenv.EnvType<typeof schema>;

export const schema = {
    MB_API_BASE_URL: String,
    API_TOKEN: String,
    SITE_ID: String,
    SITEOWNER: String,
    PASSWORD: String,
    MAX_CLIENTS_TO_PROCESS: Number,
    MAX_CLIENT_REQ: Number,
    LIMITER_BACKOFFTIME: Number,
    MAX_REQUEST_RATE: Number,
    REQUEST_RATE_INTERVAL: Number,
    LIMITER_TIMEOUT: Number,
    AUDIENCE_CSV: String,
    EMAIL_COLUMN: Number,
    CSV_HAS_HEADER: String,
    MB_API_TEST_FLAG: Boolean,
    BAD_CLIENTS: String,
    REVIEW_CLIENTS: String
};

export let env: Env;

export function loadEnv(): void {
    env = tsdotenv.load(schema);
}