import { Logger } from '@l2beat/shared'
import {
  AssetId,
  ChainId,
  DetailedTvlApiResponse,
  Hash256,
  ProjectId,
  Token,
  TvlApiChart,
  TvlApiCharts,
  ValueType,
} from '@l2beat/shared-pure'

import { ReportProject } from '../../../core/reports/ReportProject'
import { AggregatedReportRepository } from '../../../peripherals/database/AggregatedReportRepository'
import { AggregatedReportStatusRepository } from '../../../peripherals/database/AggregatedReportStatusRepository'
import { ReportRepository } from '../../../peripherals/database/ReportRepository'
import { ReportStatusRepository } from '../../../peripherals/database/ReportStatusRepository'
import { getHourlyMinTimestamp } from '../utils/getHourlyMinTimestamp'
import { getSixHourlyMinTimestamp } from '../utils/getSixHourlyMinTimestamp'
import { getProjectAssetChartData } from './charts'
import {
  groupByProjectIdAndAssetType,
  groupByProjectIdAndTimestamp,
} from './detailedTvl'
import { generateDetailedTvlApiResponse } from './generateDetailedTvlApiResponse'

interface DetailedTvlControllerOptions {
  errorOnUnsyncedDetailedTvl: boolean
}

type DetailedTvlResult =
  | {
      result: 'success'
      data: DetailedTvlApiResponse
    }
  | {
      result: 'error'
      error: 'DATA_NOT_FULLY_SYNCED' | 'NO_DATA'
    }

type DetailedAssetTvlResult =
  | {
      result: 'success'
      data: TvlApiCharts
    }
  | {
      result: 'error'
      error: 'INVALID_PROJECT_OR_ASSET' | 'NO_DATA'
    }

export class DetailedTvlController {
  constructor(
    private readonly reportStatusRepository: ReportStatusRepository,
    private readonly aggregatedReportRepository: AggregatedReportRepository,
    private readonly reportRepository: ReportRepository,
    private readonly aggregatedReportStatusRepository: AggregatedReportStatusRepository,
    private readonly projects: ReportProject[],
    private readonly tokens: Token[],
    private readonly logger: Logger,
    private readonly aggregatedConfigHash: Hash256,
    private readonly options: DetailedTvlControllerOptions,
  ) {
    this.logger = this.logger.for(this)
  }

  /**
   * TODO: Add project exclusion?
   */
  async getDetailedTvlApiResponse(): Promise<DetailedTvlResult> {
    const dataTimings = await this.getDataTimings()

    if (!dataTimings.latestTimestamp) {
      return {
        result: 'error',
        error: 'NO_DATA',
      }
    }

    if (!dataTimings.isSynced && this.options.errorOnUnsyncedDetailedTvl) {
      return {
        result: 'error',
        error: 'DATA_NOT_FULLY_SYNCED',
      }
    }

    const [hourlyReports, sixHourlyReports, dailyReports, latestReports] =
      await Promise.all([
        this.aggregatedReportRepository.getHourlyWithAnyType(
          getHourlyMinTimestamp(dataTimings.latestTimestamp),
        ),

        this.aggregatedReportRepository.getSixHourlyWithAnyType(
          getSixHourlyMinTimestamp(dataTimings.latestTimestamp),
        ),

        this.aggregatedReportRepository.getDailyWithAnyType(),

        this.reportRepository.getByTimestamp(dataTimings.latestTimestamp),
      ])

    /**
     * ProjectID => Timestamp => [Report, Report, Report, Report]
     * Ideally 4 reports per project per timestamp corresponding to 4 Value Types
     */
    const groupedHourlyReports = groupByProjectIdAndTimestamp(hourlyReports)

    const groupedSixHourlyReportsTree =
      groupByProjectIdAndTimestamp(sixHourlyReports)

    const groupedDailyReports = groupByProjectIdAndTimestamp(dailyReports)

    /**
     * ProjectID => Asset => Report[]
     * Ideally 1 report. Some chains like Arbitrum may have multiple reports per asset differentiated by Value Type
     * That isl 1 report for USDC of value type CBV and 1 report for USDC of value type EBV
     * Reduce (dedupe) occurs later in the call chain
     * @see getProjectTokensCharts
     */
    const groupedLatestReports = groupByProjectIdAndAssetType(latestReports)

    const tvlApiResponse = generateDetailedTvlApiResponse(
      groupedHourlyReports,
      groupedSixHourlyReportsTree,
      groupedDailyReports,
      groupedLatestReports,
      this.projects.map((x) => x.projectId),
    )

    return {
      result: 'success',
      data: tvlApiResponse,
    }
  }

  async getDetailedAssetTvlApiResponse(
    projectId: ProjectId,
    chainId: ChainId,
    assetId: AssetId,
    assetType: ValueType,
  ): Promise<DetailedAssetTvlResult> {
    const asset = this.tokens.find((t) => t.id === assetId)
    const project = this.projects.find((p) => p.projectId === projectId)

    if (!asset || !project) {
      return {
        result: 'error',
        error: 'INVALID_PROJECT_OR_ASSET',
      }
    }

    const timestampCandidate =
      await this.reportStatusRepository.findLatestTimestamp(chainId, assetType)

    if (!timestampCandidate) {
      return {
        result: 'error',
        error: 'NO_DATA',
      }
    }

    const [hourlyReports, sixHourlyReports, dailyReports] = await Promise.all([
      this.reportRepository.getHourlyForDetailed(
        projectId,
        chainId,
        assetId,
        assetType,
        getHourlyMinTimestamp(timestampCandidate),
      ),
      this.reportRepository.getSixHourlyForDetailed(
        projectId,
        chainId,
        assetId,
        assetType,
        getSixHourlyMinTimestamp(timestampCandidate),
      ),
      this.reportRepository.getDailyForDetailed(
        projectId,
        chainId,
        assetId,
        assetType,
      ),
    ])
    const assetSymbol = asset.symbol.toLowerCase()

    const types: TvlApiChart['types'] = ['timestamp', assetSymbol, 'usd']

    return {
      result: 'success',
      data: {
        hourly: {
          types,
          data: getProjectAssetChartData(hourlyReports, asset.decimals, 1),
        },
        sixHourly: {
          types,
          data: getProjectAssetChartData(sixHourlyReports, asset.decimals, 6),
        },
        daily: {
          types,
          data: getProjectAssetChartData(dailyReports, asset.decimals, 24),
        },
      },
    }
  }

  private async getDataTimings() {
    const { matching: syncedReportsAmount, different: unsyncedReportsAmount } =
      await this.aggregatedReportStatusRepository.findCountsForHash(
        this.aggregatedConfigHash,
      )

    const latestTimestamp =
      await this.aggregatedReportStatusRepository.findLatestTimestamp()

    const isSynced = unsyncedReportsAmount === 0

    const result = {
      syncedReportsAmount,
      unsyncedReportsAmount,
      isSynced,
      latestTimestamp,
    }

    return result
  }
}
