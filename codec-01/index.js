var prefix = 'http://localhost:9494/resources/m3u8/';
var url = prefix + 'index.m3u8';
var video = document.getElementById('player');
var hls = new Hls();
hls.loadSource(url);
hls.attachMedia(video);
hls.on(Hls.Events.MEDIA_ATTACHED, function() {
    video.play();
});

httpGet(url, 'text', function(content) {
    console.log(parseM3U8(prefix, content));
});

function parseM3U8(prefix, content) {
    if(prefix == null) {
        prefix = '';
    }
    var lines = content.split(/\r?\n|\r\n?/);
    var list = [];
    for(var i = 0; i < lines.length; i++) {
        if(lines[i].indexOf('#EXT-X-ENDLIST') === 0) {
            break;
        }
        if(lines[i].indexOf('#EXTINF') === 0) {
            var start = lines[i].indexOf(':');
            var end = lines[i].indexOf(',');
            var value = lines[i].substring(start + 1, end);
            list.push({
                duration: parseFloat(value),
                url: prefix + lines[++i]
            });
        }
    }
    return list;
}

function httpGet(url, responseType, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('get', url, true);
    xhr.responseType = responseType;
    xhr.onload = function () {
        if(xhr.status === 200) {
            if(responseType == 'text') {
                callback(xhr.responseText);
            } else {
                callback(xhr.response);
            }
        } else {
            callback(null);
        }
    };
    xhr.send();
}
