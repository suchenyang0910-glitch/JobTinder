import { Module } from '@nestjs/common';
import { UserIdentityService } from './identity/user-identity.service';
import { CandidateOnboardingService } from './onboarding/candidate-onboarding.service';
import { CompanyOnboardingService } from './onboarding/company-onboarding.service';
import { AIOnboardingService } from './onboarding/ai-onboarding.service';
import { PrismaModule } from '@src/infrastructure/db/prisma/prisma.module';
import { SharedModule } from '@src/shared/shared.module';

@Module({
  imports: [SharedModule, PrismaModule],
  providers: [
    UserIdentityService,
    CandidateOnboardingService,
    CompanyOnboardingService,
    AIOnboardingService,
  ],
  exports: [
    UserIdentityService,
    CandidateOnboardingService,
    CompanyOnboardingService,
    AIOnboardingService,
  ],
})
export class ApplicationModule {}
