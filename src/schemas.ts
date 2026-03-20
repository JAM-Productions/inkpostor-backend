import { z } from 'zod';

export const JoinCreateRoomSchema = z.object({
    roomId: z.string(),
});

export const StrokeSchema = z.object({
    x: z.number().min(-500).max(5000),
    y: z.number().min(-500).max(5000),
    color: z.string().min(3).max(20),
    isNewStroke: z.boolean(),
});

export const VoteSchema = z.string();
