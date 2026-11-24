import { randomUUID } from 'node:crypto';
import { profileAttemptId } from '../api/client.js';
import {
  ApiError,
  CaptureError,
  PreconditionError,
  UsageError,
} from '../errors.js';
import { recordProfileSetupEvent } from './index.js';

/** One upload/refresh invocation. Retries using --attempt-id keep their join key. */
export const withProfileSetup = async <T>(
  suppliedId: string | undefined,
  operation: 'create' | 'refresh',
  work: (setup: {
    attemptId: string;
    ready: () => void;
    submit: () => void;
  }) => Promise<T>,
): Promise<T> => {
  const attemptId = profileAttemptId(suppliedId) ?? randomUUID();
  const sent = new Set<string>();
  let step = 'capture';
  const emit = (name: string, properties: Record<string, string> = {}) => {
    if (sent.has(name)) return;
    sent.add(name);
    recordProfileSetupEvent({
      event_type: name,
      time: Date.now(),
      event_properties: {
        attempt_id: attemptId,
        setup_method: 'cli',
        source: 'cli',
        operation,
        ...properties,
      },
    });
  };
  emit('Profile Setup Method Selected');
  emit('Profile Setup Started');
  try {
    return await work({
      attemptId,
      // Successful capture proves a browser really ran; copying a command does not.
      ready: () => {
        emit('Profile Setup Ready');
      },
      submit: () => {
        step = 'save';
        emit('Profile Save Submitted');
      },
    });
  } catch (error) {
    // Classify known categories, never error messages, paths, or response bodies.
    const reason =
      error instanceof ApiError
        ? error.status === 0
          ? 'connection_failed'
          : error.status < 500
            ? 'validation_rejected'
            : 'server_failed'
        : error instanceof UsageError
          ? 'validation_rejected'
          : error instanceof PreconditionError
            ? 'precondition_failed'
            : error instanceof CaptureError
              ? 'capture_failed'
              : 'internal_error';
    emit('Profile Setup Failed', { step, reason_code: reason });
    throw error;
  }
};
