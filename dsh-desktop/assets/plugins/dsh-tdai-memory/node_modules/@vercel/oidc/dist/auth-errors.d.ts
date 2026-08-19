/**
 * Error thrown when no authentication configuration is found.
 * This typically means the user needs to log in.
 */
export declare class AccessTokenMissingError extends Error {
    name: string;
    constructor();
}
/**
 * Error thrown when attempting to refresh the authentication token fails.
 * This includes cases where no refresh token is available.
 */
export declare class RefreshAccessTokenFailedError extends Error {
    name: string;
    constructor(cause?: unknown);
}
