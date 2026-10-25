export declare const config: {
    nodeEnv: string;
    port: number;
    host: string;
    dbPath: string;
    dbMode: string;
    jwtSecret: string;
    jwtExpirationDays: number;
    apiKeySalt: string;
    bcryptRounds: number;
    adminPassword: string;
    trustProxy: boolean;
    corsOrigins: string[];
    rateLimitMax: number;
    bodyLimitMB: number;
    maxQueryLimit: number;
    exposeVersion: boolean;
    logLevel: string;
    maxConnections: number;
    cacheSizeMB: number;
    enableCompression: boolean;
    persistDebounceMs: number;
    walFsync: boolean;
    queryCacheEntries: number;
    storageEngine: "disk" | "memory";
    cluster: {
        enabled: boolean;
        nodeId: string;
        /** How the other members reach this node, e.g. http://10.0.0.5:4402 */
        advertiseUrl: string;
        peers: string[];
        /** Shared secret (32+ chars): authenticates and encrypts all cluster traffic. */
        secret: string;
        /** async: acknowledge after the primary's own commit. majority: also wait for a majority of members. */
        writeConcern: "async" | "majority";
        electionTimeoutMs: number;
        writeTimeoutMs: number;
        /** Log entries kept beyond what every member has applied (lets lagging replicas catch up without a full copy). */
        logRetention: number;
        /** Higher = preferred primary in elections (ties broken by node id). 0 = never becomes primary. */
        priority: number;
    };
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
    admin: {
        enabled: boolean;
        path: string;
        allowedIps: string[];
        require2fa: boolean;
        sessionTimeoutMinutes: number;
    };
};
//# sourceMappingURL=config.d.ts.map