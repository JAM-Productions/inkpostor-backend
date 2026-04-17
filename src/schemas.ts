import { z } from 'zod';

export const UserPayloadSchema = z.object({
    userId: z.string(),
    name: z.string(),
});

export const CreateRoomSchema = z.object({
    roomId: z.string().min(1),
});

export const JoinRoomSchema = z.object({
    roomId: z.string().min(1),
});

export const StrokeDataSchema = z.object({
    x: z.number(),
    y: z.number(),
    color: z.string(),
    isNewStroke: z.boolean(),
});

export const VoteSchema = z.string();
