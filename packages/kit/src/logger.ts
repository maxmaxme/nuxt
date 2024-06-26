import pino from 'pino'
import ecsFormat from '@elastic/ecs-pino-format'

export const logger = pino(ecsFormat())

export function useLogger () {
  return logger
}
