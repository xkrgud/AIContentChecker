import React from 'react';

export type ActiveTab = 'analyze' | 'checklist' | 'history' | 'share-guide';

interface HeaderProps {
  activeTab: ActiveTab;
  hasReport: boolean;
  historyCount: number;
  onSelectTab: (tab: ActiveTab) => void;
  onResetToNew: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  hasReport,
  historyCount,
  onSelectTab,
  onResetToNew,
}) => {
  const navItems: Array<{ id: ActiveTab; label: string }> = [
    { id: 'analyze', label: hasReport ? '분석 결과' : '콘텐츠 분석' },
    { id: 'checklist', label: '신뢰성 체크리스트' },
    { id: 'history', label: historyCount > 0 ? `분석 기록 (${historyCount})` : '분석 기록' },
    { id: 'share-guide', label: '외부 공유' },
  ];

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 py-3.5 sm:px-6">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onResetToNew();
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          AI Content Checker
        </a>

        <nav
          aria-label="주요 메뉴"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 ${
                  isActive
                    ? 'text-slate-950 font-semibold underline decoration-blue-700 decoration-2 underline-offset-8'
                    : 'text-slate-600 hover:text-slate-950'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onResetToNew}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            새 분석
          </button>
        </div>
      </div>

      <nav
        aria-label="모바일 메뉴"
        className="flex md:hidden items-center gap-1 overflow-x-auto border-t border-slate-100 px-4 py-1.5 text-xs font-medium"
      >
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`rounded-md px-3 py-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                isActive
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
};
