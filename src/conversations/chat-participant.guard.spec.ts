import {
  BadRequestException,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ChatParticipantGuard } from './chat-participant.guard';
import type { ConversationsService } from './conversations.service';

const CONVERSATION = '22222222-2222-4222-8222-222222222222';

function ctx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('ChatParticipantGuard', () => {
  let assertParticipant: jest.Mock;
  let guard: ChatParticipantGuard;
  const req = (id: string) => ({
    user: { id: 'u1' },
    accessToken: 't',
    params: { id },
  });

  beforeEach(() => {
    assertParticipant = jest.fn().mockResolvedValue(undefined);
    guard = new ChatParticipantGuard({
      assertParticipant,
    } as unknown as ConversationsService);
  });

  it('deja pasar a un participante', async () => {
    await expect(guard.canActivate(ctx(req(CONVERSATION)))).resolves.toBe(true);
    expect(assertParticipant).toHaveBeenCalledWith('u1', CONVERSATION);
  });

  it('una conversación ajena da 404', async () => {
    assertParticipant.mockRejectedValue(new NotFoundException());
    await expect(
      guard.canActivate(ctx(req(CONVERSATION))),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un id que no es UUID da 400 sin consultar', async () => {
    await expect(guard.canActivate(ctx(req('x')))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(assertParticipant).not.toHaveBeenCalled();
  });

  it('sin sesión da 401', async () => {
    await expect(
      guard.canActivate(ctx({ params: { id: CONVERSATION } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
