

/**
 * TODO JSDoc
 */
export declare function getLoadablePath(): string;


interface Db {
    loadExtension(file: string, entrypoint?: string | undefined): void;
}

/**
 * TODO JSDoc
 */
export declare function load(db: Db): void;

