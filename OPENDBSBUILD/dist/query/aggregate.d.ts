/**
 * MongoDB-style aggregation pipeline over rack documents.
 *
 * Stages: $match $project $addFields/$set $unset $group $sort $skip $limit
 *         $count $unwind $lookup $replaceRoot $sortByCount
 * Accumulators ($group): $sum $avg $min $max $count $push $addToSet $first $last
 * Expressions: "$field.path", literals, and
 *   arithmetic  $add $subtract $multiply $divide $mod $abs $round $floor $ceil
 *   string      $concat $toUpper $toLower $substr $trim $strLen $split
 *   compare     $eq $ne $gt $gte $lt $lte $in
 *   logic       $and $or $not $cond $ifNull
 *   array       $size $arrayElemAt
 *   date        $year $month $dayOfMonth $hour $dateToString
 *   convert     $toString $toInt $toDouble $literal
 * Document ids are in `id`; $group output keys its group in `_id` (MongoDB convention).
 */
export interface AggregateContext {
    /** Documents of another rack (same database) whose `field` equals one of `values`. */
    lookup(rack: string, field: string, values: any[]): any[];
}
export declare function evalExpr(expr: any, doc: any): any;
export type AccName = '$sum' | '$avg' | '$min' | '$max' | '$count' | '$push' | '$addToSet' | '$first' | '$last';
export interface Accumulator {
    add(v: any): void;
    result(): any;
}
export declare function makeAccumulator(name: AccName): Accumulator;
/** Runs `pipeline` over `input` (each doc includes `id`). */
export declare function runPipeline(input: any[], pipeline: any[], ctx: AggregateContext): any[];
//# sourceMappingURL=aggregate.d.ts.map