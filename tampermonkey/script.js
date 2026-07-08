// ==UserScript==
// @name         tlx-predictor
// @namespace    https://github.com/bramar2
// @version      1.0
// @description  Predict live rating changes in TLX.
// @author       bramar2
// @match        https://tlx.toki.id/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    const DESCRIPTION_REGEX = /https:\/\/api.tlx.toki.id\/v2\/contests\/([a-zA-Z0-9]+)\/description.*/;
    const SCOREBOARD_REGEX = /https:\/\/api.tlx.toki.id\/v2\/contests\/([a-zA-Z0-9]+)\/scoreboard.*/;
    let deltas = undefined;

    function score(hiddenA, hiddenB, N) {
        return Math.max(10, (1.0 / (1 + Math.exp(-Math.sqrt(hiddenB / hiddenA))) - 0.7) * Math.log2(N) * 1800);
    }

    async function processDescription(contestJID, data) {
        // Heuristic to obtain a contest's rated range.
        const description = data.description;
        let range = [];
        if(/(\((Div\.|Divisi) 2\))|(>\s*Rated( [a-zA-Z]+ | )(Div\.|Divisi) 2)/gi.test(description)) {
            range = [0, 1999];
        }else if(/(\((Div\.|Divisi) 1\))|(>\s*Rated( [a-zA-Z]+ | )(Div\.|Divisi) 1)/gi.test(description)) {
            range = [2000, 9999];
        }else if(/(>\s*Rated( [a-zA-Z]+ | )(all|every)|>\s*Rated>)/gi.test(description)) {
            range = [0, 9999];
        }else {
            range = [-1, -1];
        }

        await GM.setValue(contestJID, range);
    }

    async function processScoreboard(contestJID, data) {
        const range = await GM.getValue(contestJID, undefined);
        
        if(range) {
            deltas = undefined;
            const jidToUsername = new Map();
            const publicRatingMap = new Map();
            const hiddenRatingMap = new Map();
            const unrated = new Set();
            
            for(const [userJID, profile] of Object.entries(data.profilesMap)) {
                jidToUsername.set(userJID, profile.username.toLowerCase());
                if(profile.rating) {
                    publicRatingMap.set(userJID, profile.rating.publicRating);
                    hiddenRatingMap.set(userJID, profile.rating.hiddenRating);
                }else {
                    publicRatingMap.set(userJID, 1800);
                    hiddenRatingMap.set(userJID, 1800);
                    unrated.add(userJID);
                }
            }

            const remapRank = new Map();
            const contestants = [];

            for(const row of data.data.scoreboard.content.entries) {
                const publicRating = publicRatingMap.get(row.contestantJid);
                const hiddenRating = hiddenRatingMap.get(row.contestantJid);
                const rank = row.rank;
                let attempts = 0;

                for(const cnt of row.attemptsList) {
                    attempts += cnt;
                }

                if(attempts > 0 && range[0] <= publicRating && publicRating <= range[1]) {
                    if(!remapRank.has(rank)) remapRank.set(rank, remapRank.size + 1);
                    contestants.push({
                        "id": row.contestantJid,
                        "rank": remapRank.get(rank),
                        "publicRating": publicRating,
                        "hiddenRating": hiddenRating
                    });
                }
            }

            const N = contestants.length;
            if(N === 0) return;

            deltas = new Map();
            for(let a = 0; a < N; a++) {
                const id = contestants[a].id;
                const rank = contestants[a].rank;
                const hiddenRating = contestants[a].hiddenRating;
                let publicRating = contestants[a].publicRating;
                let delta = 0;
                for(let b = 0; b < N; b++) if(a != b) {
                    if(rank < contestants[b].rank) {
                        delta += score(hiddenRating, contestants[b].hiddenRating, N);
                    }else if(rank > contestants[b].rank) {
                        delta -= score(contestants[b].hiddenRating, hiddenRating, N);
                    }
                }
                delta /= N;

                let debt = hiddenRating - publicRating;
                if(delta >= 0) {
                    publicRating += 0.2 * delta;
                    debt += 0.8 * delta;
                    if(debt > 0) {
                        publicRating += debt;
                        debt = 0;
                    }
                }else {
                    debt += delta;
                    publicRating += 0.5 * debt;
                    debt = 0.5 * debt;
                }

                publicRating = Math.floor(publicRating);
                if(unrated.has(id)) {
                    deltas.set(jidToUsername.get(id), publicRating);
                }else {
                    deltas.set(jidToUsername.get(id), publicRating - contestants[a].publicRating);
                }
            }
        }
    }

    function updateScoreboard() {
        const scoreTable = document.querySelector('.scoreboard__content');
        if(!scoreTable || !deltas) return;

        if(!scoreTable.querySelector('#tlx-predictor-column')) {
            scoreTable.querySelector('thead > tr').innerHTML += '<th id="tlx-predictor-column" class="rank-cell">Δ</th>';
        }

        for(const row of scoreTable.querySelectorAll('tbody > tr')) {
            const username = row.querySelector('.user-ref__username').innerText.toLowerCase();
            let info = document.createElement('td');
            info.classList.add("tlx-predictor-delta");

            if(deltas.has(username)) {
                const delta = deltas.get(username);
                if(delta >= 0) {
                    info.innerText = "+" + delta;
                    info.style.color = "#e1fdd7";
                    info.style.fontWeight = "700";
                }else {
                    info.innerText = "" + delta;
                    info.style.color = "#e36262";
                    info.style.fontWeight = "700";
                }
            }else {
                info.innerText = "—";
            }

            const old = row.querySelector('.tlx-predictor-delta');
            if(old) {
                old.replaceWith(info);
            }else {
                row.appendChild(info);
            }
        }
    }

    const ofetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const response = await ofetch.apply(this, args);
        
        const descriptionMatch = response.url.match(DESCRIPTION_REGEX);
        if(descriptionMatch) {
            response.clone().json().then((data) => processDescription(descriptionMatch[1], data));
        }

        const scoreboardMatch = response.url.match(SCOREBOARD_REGEX);
        if(scoreboardMatch) {
            response.clone().json().then((data) => processScoreboard(scoreboardMatch[1], data));
        }
        return response;
    };

    setTimeout(updateScoreboard, 1000);
    setTimeout(updateScoreboard, 2000);
    setTimeout(updateScoreboard, 3000);
    setInterval(updateScoreboard, 5000);
})();