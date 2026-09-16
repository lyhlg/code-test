// 시술 후 환불 정책: 경과일에 따른 환불율 계산
export function getRefundRate(daysSinceTreatment: number): number {
  if (daysSinceTreatment <= 7) return 1.0;   // 7일 이내 전액 환불
  if (daysSinceTreatment <= 14) return 0.5;  // 8~14일 50% 환불
  return 0;                                   // 15일 이후 환불 불가
}
