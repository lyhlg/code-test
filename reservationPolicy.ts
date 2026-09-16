/**
 * 예약 정책 (Reservation Policy) 예시
 *
 * 병원 예약의 생성 / 취소 / 노쇼(no-show) 규칙을 한곳에 모은 도메인 코드입니다.
 * - 예약 취소 시점에 따라 위약금(취소 수수료)이 달라집니다.
 * - 운영 시간 / 리드타임(최소 예약 가능 시간) 규칙을 검증합니다.
 */

// ─────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────

export type ReservationStatus =
  | 'REQUESTED' // 예약 요청됨 (병원 확정 전)
  | 'CONFIRMED' // 병원이 확정함
  | 'CANCELLED' // 취소됨
  | 'COMPLETED' // 방문 완료
  | 'NO_SHOW'; // 노쇼

export interface Reservation {
  id: string;
  userId: string;
  hospitalId: string;
  /** 예약된 진료 시작 시각 */
  scheduledAt: Date;
  /** 결제(예약금) 금액. 예약금이 없으면 0 */
  depositAmount: number;
  status: ReservationStatus;
  createdAt: Date;
}

export interface PolicyResult {
  allowed: boolean;
  /** 위약금(취소 수수료) 금액 */
  penaltyAmount: number;
  /** 환불 금액 */
  refundAmount: number;
  reason: string;
}

// ─────────────────────────────────────────────
// 정책 상수
// ─────────────────────────────────────────────

export const ReservationPolicyConfig = {
  /** 예약 가능한 최소 리드타임 (지금으로부터 최소 이 시간 이후만 예약 가능) */
  MIN_LEAD_TIME_HOURS: 2,
  /** 예약 가능한 최대 기간 (며칠 후까지 예약 가능한지) */
  MAX_ADVANCE_DAYS: 60,
  /** 운영 시작 시각 (24시간제) */
  OPEN_HOUR: 10,
  /** 운영 종료 시각 (24시간제) */
  CLOSE_HOUR: 20,
  /**
   * 취소 위약금 구간.
   * 진료 시작까지 남은 시간(hoursBefore) 이상이면 해당 위약금 비율 적용.
   * 위에서부터 순서대로 평가하며, 먼저 조건을 만족하는 구간을 사용합니다.
   */
  CANCELLATION_TIERS: [
    { hoursBefore: 48, penaltyRate: 0 }, // 48시간 이전: 전액 환불
    { hoursBefore: 24, penaltyRate: 0.2 }, // 24~48시간 전: 20% 위약금
    { hoursBefore: 0, penaltyRate: 0.5 }, // 24시간 이내: 50% 위약금
  ],
  /** 노쇼 시 위약금 비율 (예약금 전액 몰수) */
  NO_SHOW_PENALTY_RATE: 1.0,
} as const;

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────

const MS_PER_HOUR = 1000 * 60 * 60;

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_HOUR;
}

// ─────────────────────────────────────────────
// 예약 생성 정책
// ─────────────────────────────────────────────

/**
 * 예약 가능 여부를 검증합니다.
 * @param scheduledAt 예약하려는 진료 시각
 * @param now 현재 시각 (테스트 편의를 위해 주입)
 */
export function canCreateReservation(
  scheduledAt: Date,
  now: Date = new Date(),
): PolicyResult {
  const deny = (reason: string): PolicyResult => ({
    allowed: false,
    penaltyAmount: 0,
    refundAmount: 0,
    reason,
  });

  const leadTime = hoursBetween(now, scheduledAt);

  if (leadTime < 0) {
    return deny('이미 지난 시간은 예약할 수 없습니다.');
  }

  if (leadTime < ReservationPolicyConfig.MIN_LEAD_TIME_HOURS) {
    return deny(
      `예약은 최소 ${ReservationPolicyConfig.MIN_LEAD_TIME_HOURS}시간 이후부터 가능합니다.`,
    );
  }

  const daysAhead = leadTime / 24;
  if (daysAhead > ReservationPolicyConfig.MAX_ADVANCE_DAYS) {
    return deny(
      `예약은 최대 ${ReservationPolicyConfig.MAX_ADVANCE_DAYS}일 이내만 가능합니다.`,
    );
  }

  const hour = scheduledAt.getHours();
  if (
    hour < ReservationPolicyConfig.OPEN_HOUR ||
    hour >= ReservationPolicyConfig.CLOSE_HOUR
  ) {
    return deny(
      `운영 시간(${ReservationPolicyConfig.OPEN_HOUR}시~${ReservationPolicyConfig.CLOSE_HOUR}시) 내에서만 예약할 수 있습니다.`,
    );
  }

  return {
    allowed: true,
    penaltyAmount: 0,
    refundAmount: 0,
    reason: '예약 가능합니다.',
  };
}

// ─────────────────────────────────────────────
// 예약 취소 정책
// ─────────────────────────────────────────────

/**
 * 예약 취소 시 위약금과 환불 금액을 계산합니다.
 * @param reservation 취소하려는 예약
 * @param now 현재 시각
 */
export function cancelReservation(
  reservation: Reservation,
  now: Date = new Date(),
): PolicyResult {
  if (
    reservation.status === 'CANCELLED' ||
    reservation.status === 'COMPLETED' ||
    reservation.status === 'NO_SHOW'
  ) {
    return {
      allowed: false,
      penaltyAmount: 0,
      refundAmount: 0,
      reason: `이미 종료된 예약(${reservation.status})은 취소할 수 없습니다.`,
    };
  }

  const hoursBefore = hoursBetween(now, reservation.scheduledAt);

  // 이미 진료 시각이 지난 경우 → 노쇼 처리 대상
  if (hoursBefore < 0) {
    const penalty = Math.round(
      reservation.depositAmount * ReservationPolicyConfig.NO_SHOW_PENALTY_RATE,
    );
    return {
      allowed: false,
      penaltyAmount: penalty,
      refundAmount: reservation.depositAmount - penalty,
      reason: '예약 시간이 지나 취소할 수 없습니다. (노쇼 처리 대상)',
    };
  }

  const tier = ReservationPolicyConfig.CANCELLATION_TIERS.find(
    (t) => hoursBefore >= t.hoursBefore,
  ) ?? { penaltyRate: 0.5 }; // 안전장치: 어떤 구간에도 안 걸리면 50%

  const penaltyAmount = Math.round(reservation.depositAmount * tier.penaltyRate);
  const refundAmount = reservation.depositAmount - penaltyAmount;

  return {
    allowed: true,
    penaltyAmount,
    refundAmount,
    reason:
      tier.penaltyRate === 0
        ? '전액 환불되었습니다.'
        : `취소 수수료 ${tier.penaltyRate * 100}%가 부과되었습니다.`,
  };
}

// ─────────────────────────────────────────────
// 사용 예시
// ─────────────────────────────────────────────

if (require.main === module) {
  const now = new Date('2026-09-16T12:00:00');

  // 예약 생성 검증
  console.log(
    '내일 오후 3시 예약:',
    canCreateReservation(new Date('2026-09-17T15:00:00'), now),
  );
  console.log(
    '1시간 뒤 예약 (리드타임 부족):',
    canCreateReservation(new Date('2026-09-16T13:00:00'), now),
  );

  // 예약 취소 검증
  const reservation: Reservation = {
    id: 'rsv_001',
    userId: 'user_1',
    hospitalId: 'hospital_1',
    scheduledAt: new Date('2026-09-17T15:00:00'), // 약 27시간 후
    depositAmount: 50000,
    status: 'CONFIRMED',
    createdAt: new Date('2026-09-10T10:00:00'),
  };

  console.log('27시간 전 취소:', cancelReservation(reservation, now));
}
