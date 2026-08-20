export interface RefreshTokenOptions {
    /**
     * Team ID (team_*) or slug to use for token refresh.
     * When provided, this team will be used instead of reading from `.vercel/project.json`.
     */
    team?: string;
    /**
     * Project ID (prj_*) or slug to use for token refresh.
     * When provided, this project will be used instead of reading from `.vercel/project.json`.
     */
    project?: string;
    /**
     * Optional time buffer in milliseconds before token expiry to consider it expired.
     * When provided, the token will be refreshed if it expires within this buffer time.
     * @default 0
     */
    expirationBufferMs?: number;
}
export declare function refreshToken(options?: RefreshTokenOptions): Promise<void>;
