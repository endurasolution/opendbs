export declare const config: {
    nodeEnv: string;
    port: number;
    host: string;
    dbPath: string;
    dbMode: string;
    jwtSecret: string;
    apiKeySalt: string;
    logLevel: string;
    maxConnections: number;
    cacheSizeMB: number;
    enableCompression: boolean;
    enableFuzzySearch: boolean;
    enableSemanticSearch: boolean;
    enableVectorSearch: boolean;
    backup: {
        enabled: boolean;
        path: string;
        schedule: string;
        retentionDays: number;
        type: "local" | "s3" | "ftp" | "sftp";
        s3: {
            bucket: string;
            region: string;
            accessKey: string;
            secretKey: string;
        } | undefined;
        ftp: {
            host: string;
            port: number;
            user: string;
            password: string;
        } | undefined;
    };
    sql: {
        enabled: boolean;
        port: number;
        apiPort: number;
        mysql: {
            host: string;
            port: number;
            user: string;
            password: string;
            database: string;
        } | undefined;
    };
    webInterfaceEnabled: boolean;
    showEnvOnWeb: boolean;
};
//# sourceMappingURL=config.d.ts.map