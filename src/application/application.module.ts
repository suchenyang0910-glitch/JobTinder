import { Module } from '@nestjs/common';
import { UserIdentityService } from './identity/user-identity.service';
import { CandidateOnboardingService } from './onboarding/candidate-onboarding.service';
import { CompanyOnboardingService } from './onboarding/company-onboarding.service';
import { AIOnboardingService } from './onboarding/ai-onboarding.service';
import { CrawlerQAService } from './crawler/crawler-qa.service';
import { CrawlerOrchestrator } from './crawler/crawler-orchestrator.service';
import { CrawlerReviewService } from './crawler/crawler-review.service';
import { CrawlerSchedulerService } from './crawler/crawler-scheduler.service';
import {
  SourceImportService,
  SourceReviewService as SourceRegistryReviewService,
  SourceValidationService,
} from './crawler/source-import.service';
import { PrismaModule } from '@src/infrastructure/db/prisma/prisma.module';
import { SharedModule } from '@src/shared/shared.module';

@Module({
  imports: [SharedModule, PrismaModule],
  providers: [
    UserIdentityService,
    CandidateOnboardingService,
    CompanyOnboardingService,
    AIOnboardingService,
    CrawlerQAService,
    CrawlerOrchestrator,
    CrawlerReviewService,
    CrawlerSchedulerService,
    SourceImportService,
    SourceRegistryReviewService,
    SourceValidationService,
  ],
  exports: [
    UserIdentityService,
    CandidateOnboardingService,
    CompanyOnboardingService,
    AIOnboardingService,
    CrawlerQAService,
    CrawlerOrchestrator,
    CrawlerReviewService,
    CrawlerSchedulerService,
    SourceImportService,
    SourceRegistryReviewService,
    SourceValidationService,
  ],
})
export class ApplicationModule {}
