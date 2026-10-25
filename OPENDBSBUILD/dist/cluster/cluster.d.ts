import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OpenDBSEngine } from '../engine';
/**
 * Replication + automatic failover.
 *
 * One member is the primary (leader); the others are read-only replicas.
 * Every committed storage batch on the primary is also written, in the
 * same atomic commit, to a replication log keyed by LSN. Replicas pull the
 * log (long-poll) and apply the very same batches, so their stores are
 * identical — documents, indexes and metadata alike.
 *
 * Failover is a Raft-style election: terms, one vote per term, and a vote
 * only for a candidate whose log is at least as complete as the voter's.
 * A primary that loses contact with a majority steps down, so two
 * primaries can't accept writes at the same time. With
 * REPLICATION_SYNC=majority a write is acknowledged only once a majority
 * has it, so an acknowledged write survives any single failure.
 *
 * All member-to-member traffic is authenticated and encrypted with a key
 * derived from CLUSTER_SECRET (AES-256-GCM, timestamped against replay).
 * Clients may talk to any member: replicas serve reads and forward writes.
 */
export type Role = 'leader' | 'follower' | 'candidate';
export interface ClusterHooks {
    /** Called before a full resync wipes this node's data (e.g. take a safety backup). */
    beforeWipe?: () => Promise<void>;
    /** Auth secrets every member must share (token signing key, 2FA master key). */
    secrets: {
        get(): {
            jwt: string;
            master: string;
        };
        adopt(s: {
            jwt: string;
            master: string;
        }): void;
    };
}
export declare class ClusterManager {
    private engine;
    private hooks;
    private opts;
    role: Role;
    private state;
    leaderId: string | null;
    leaderUrl: string | null;
    readonly nodeId: string;
    private readonly url;
    private readonly key;
    private readonly peers;
    private readonly store;
    private lastLeaderContact;
    private electionDeadline;
    private pauseElectionsUntil;
    private forced;
    private running;
    private timers;
    private logWaiters;
    private applyWaiters;
    private ackWaiters;
    private syncing;
    readonly stats: {
        entriesApplied: number;
        fullSyncs: number;
        elections: number;
        forwarded: number;
        lastError: string | null;
        lastFullSyncAt: string | null;
    };
    constructor(engine: OpenDBSEngine, hooks: ClusterHooks, opts?: {
        enabled: boolean;
        nodeId: string;
        advertiseUrl: string;
        peers: string[];
        secret: string;
        writeConcern: "async" | "majority";
        electionTimeoutMs: number;
        writeTimeoutMs: number;
        logRetention: number;
        priority: number;
    });
    start(): void;
    stop(): void;
    private saveState;
    get term(): number;
    private majority;
    seal(msg: any): string;
    open(sealed: string): any;
    private call;
    private becomeLeader;
    private becomeFollower;
    private resetElectionTimer;
    /** Periodic: follower election timeout, leader lease. */
    private tick;
    private startElection;
    private discoverLeader;
    private followLoop;
    /** Copies the primary's whole store, then follows its log from the copy's LSN. */
    private fullSync;
    /** Waits (bounded) until this replica has applied `lsn` — read-your-writes after a forwarded write. */
    private waitApplied;
    private wakeLogWaiters;
    private waitForLog;
    private termAt;
    private extraPeers;
    /** The configured member a request came from (by advertised URL, else node id). */
    private peerFor;
    private onPull;
    private onVote;
    private onSyncStart;
    private onSyncScan;
    private status;
    /** Handles an encrypted member-to-member request. */
    handleRpc(sealed: string): Promise<string>;
    private checkAckWaiters;
    private replicatedTo;
    /** REPLICATION_SYNC=majority: resolves once a majority of members has applied `lsn`. */
    awaitReplication(lsn: number): Promise<void>;
    private retention;
    stepDown(): void;
    electNow(): void;
    /** Last resort when a majority is gone for good (e.g. 2-member cluster, one member lost). */
    forcePrimary(): void;
    info(): {
        enabled: boolean;
        nodeId: string;
        url: string;
        role: Role;
        term: number;
        leaderId: string | null;
        leaderUrl: string | null;
        forced: boolean;
        syncing: boolean;
        synced: boolean;
        lineage: string | null;
        writeConcern: "async" | "majority";
        majority: number;
        members: number;
        lastLsn: number;
        committedLsn: number;
        firstLsn: number;
        peers: {
            url: string;
            nodeId: string | null;
            role: Role | null;
            term: number | null;
            ackLsn: number;
            lag: number | null;
            lastContactMsAgo: number | null;
            error: string | null;
        }[];
        stats: {
            entriesApplied: number;
            fullSyncs: number;
            elections: number;
            forwarded: number;
            lastError: string | null;
            lastFullSyncAt: string | null;
        };
    };
    /** Verified client IP of a request forwarded by another member. */
    adoptForwardedIp(request: FastifyRequest): void;
    private isRead;
    shouldForward(request: FastifyRequest): boolean;
    forward(request: FastifyRequest, reply: FastifyReply): Promise<never>;
    /** Routes + hooks. Call before other routes are registered. */
    register(fastify: FastifyInstance): void;
}
//# sourceMappingURL=cluster.d.ts.map