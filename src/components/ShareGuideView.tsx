import React, { useState } from 'react';
import { Download, ExternalLink, Film, Share2, Smartphone } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface ShareGuideViewProps {
  onSimulateShareTarget: (url: string, title: string) => void;
  onSimulateVideoShare: () => void;
}

export const ShareGuideView: React.FC<ShareGuideViewProps> = ({
  onSimulateShareTarget,
  onSimulateVideoShare,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSModal, setShowIOSModal] = useState(false);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10 space-y-8">
      <div className="border-b border-slate-200 pb-6">
        <p className="text-xs font-medium text-slate-500">Web Share Target · 모바일 앱 연동</p>
        <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          외부 앱·갤러리에서 바로 공유해 분석하기
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          YouTube, Instagram 릴스 링크는 물론이고 안드로이드 갤러리에 저장한 영상 파일(mp4, mov)을
          공유 메뉴에서 <strong className="font-semibold text-slate-900">AI Content Checker</strong>로
          보내면 업로드 칸에 바로 들어갑니다.
        </p>
      </div>

      {/* PWA Install & Share Target Status */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <img
              src="/pwa-192x192.png"
              alt="AI Content Checker 앱 아이콘"
              className="h-12 w-12 rounded-xl border border-slate-200 shrink-0"
            />
            <div>
              <h2 className="text-base font-bold text-slate-950">홈 화면에 웹 앱(PWA) 설치</h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                {isInstalled
                  ? '현재 설치된 앱 모드로 실행 중입니다. Android 공유 시트에서 링크와 갤러리 영상을 바로 보낼 수 있습니다.'
                  : '브라우저에서 홈 화면에 추가하면 Android 공유 메뉴에 AI Content Checker가 등록됩니다.'}
              </p>
            </div>
          </div>

          <div className="shrink-0">
            {isInstallable && !isInstalled && (
              <button
                type="button"
                onClick={install}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 whitespace-nowrap cursor-pointer"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                앱 설치하기
              </button>
            )}
            {!isInstallable && isIOS && !isInstalled && (
              <button
                type="button"
                onClick={() => setShowIOSModal(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
              >
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                iOS 설치 방법 보기
              </button>
            )}
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-600 space-y-1.5">
          <p className="font-semibold text-slate-900">공유 방식별 안내</p>
          <p>
            • <strong className="text-slate-800">링크 공유 (?url= / 공유 시트)</strong>: 외부 앱의
            공유하기로 전달된 URL을 분석 입력창에 자동 등록합니다.
          </p>
          <p>
            • <strong className="text-slate-800">갤러리 영상 공유 (video/*)</strong>: 인스타그램
            공유 버튼 → &apos;다운로드&apos;로 저장한 릴스나 휴대폰 갤러리 영상을 바로 공유하면
            업로드 칸에 자동으로 들어갑니다.
          </p>
        </div>
      </div>

      {/* Share Target Simulation for Desktop/Testing */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
        <div className="flex items-start gap-3">
          <Share2 className="mt-0.5 h-5 w-5 text-blue-700 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <h2 className="text-base font-bold text-slate-950">외부 앱 공유 전달 동작 테스트</h2>
            <p className="text-sm text-slate-600">
              데스크톱 환경이나 브라우저 테스트 시, 링크 공유(
              <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
                ?url=...&amp;title=...
              </code>
              ) 및 갤러리 영상 파일 공유(
              <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
                multipart/form-data
              </code>
              ) 동작을 바로 체험할 수 있습니다.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            onClick={() =>
              onSimulateShareTarget(
                'https://www.instagram.com/reel/C8xSampleHealth99/',
                '인스타그램 릴스 공유 테스트'
              )
            }
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-100 cursor-pointer"
          >
            <ExternalLink className="h-4 w-4 text-slate-600" aria-hidden="true" />
            인스타그램 릴스 공유 시뮬레이션
          </button>
          <button
            type="button"
            onClick={() =>
              onSimulateShareTarget(
                'https://www.youtube.com/shorts/dQw4w9WgXcQ',
                '유튜브 쇼츠 공유 테스트'
              )
            }
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 hover:bg-slate-100 cursor-pointer"
          >
            <ExternalLink className="h-4 w-4 text-slate-600" aria-hidden="true" />
            유튜브 쇼츠 공유 시뮬레이션
          </button>
          <button
            type="button"
            onClick={onSimulateVideoShare}
            className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-950 hover:bg-blue-100 cursor-pointer"
          >
            <Film className="h-4 w-4 text-blue-700" aria-hidden="true" />
            갤러리 영상 공유 시뮬레이션
          </button>
        </div>
      </div>

      {showIOSModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ios-guide-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 space-y-4">
            <h3 id="ios-guide-title" className="text-lg font-bold text-slate-950">
              iPhone · iPad 홈 화면 추가 안내
            </h3>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700">
              <li>Safari 하단 또는 상단의 공유 버튼을 누릅니다.</li>
              <li>메뉴를 아래로 내려 &ldquo;홈 화면에 추가&rdquo;를 선택합니다.</li>
              <li>오른쪽 상단 &ldquo;추가&rdquo;를 누르면 앱처럼 바로 실행할 수 있습니다.</li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIOSModal(false)}
              className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 cursor-pointer"
            >
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
