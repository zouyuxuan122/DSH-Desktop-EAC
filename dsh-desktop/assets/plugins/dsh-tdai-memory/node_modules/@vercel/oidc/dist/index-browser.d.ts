export { getContext } from './get-context';
export { AccessTokenMissingError, RefreshAccessTokenFailedError, } from './auth-errors';
export declare function getVercelOidcToken(): Promise<string>;
export declare function getVercelOidcTokenSync(): string;
export declare function getVercelToken(): Promise<string>;
