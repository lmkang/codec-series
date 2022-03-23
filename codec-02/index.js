var url = 'http://localhost:9494/resources/m3u8/seg000.ts';

httpGet(url, 'arraybuffer', function(res) {
    var buf = new Uint8Array(res);
    var tsdemuxer = new TSDemuxer();
    tsdemuxer.demux(buf, function(data) {
        console.log(data);
    });
});

function TSDemuxer() {
    
}

TSDemuxer.prototype.probe = function(buf) {
    var offset = 0;
    while(offset < buf.length - 3 * 188) {
        if(buf[offset] === 0x47
            && buf[offset + 188] === 0x47
            && buf[offset + 188 * 2] === 0x47) {
            return offset;
        }
        offset++;
    }
    return -1;
};

TSDemuxer.prototype.demux = function(buf, callback) {
    var startOffset = this.probe(buf);
    if(startOffset === -1) {
        return null;
    }
    var pmtPID = -1;
    var audioPID = -1;
    var avcPID = -1;
    var audioData = null;
    var avcData = null;
    var frameCount = 0;
    for(var i = startOffset; i + 188 < buf.length; i += 188) {
        // payload unit start indicator
        var pus = (buf[i + 1] & 0x40) >> 6;
        // packet id
        var pid = ((buf[i + 1] & 0x1f) << 8) + buf[i + 2];
        // adaption field control
        var afc = (buf[i + 3] & 0x30) >> 4;
        var offset;
        if(afc > 1) {
            offset = i + 5 + buf[i + 4];
            if(offset === i + 188) {
                continue;
            }
        } else {
            offset = i + 4;
        }
        switch(pid) {
            // PAT
            case 0:
                if(pus === 1) {
                    offset += buf[offset] + 1;
                }
                pmtPID = this.parsePAT(buf, offset);
                break;
            // PMT
            case pmtPID:
                if(pus === 1) {
                    offset += buf[offset] + 1;
                }
                var pidInfo = this.parsePMT(buf, offset);
                if(pidInfo.audioPID !== -1) {
                    audioPID = pidInfo.audioPID;
                }
                if(pidInfo.avcPID !== -1) {
                    avcPID = pidInfo.avcPID;
                }
                break;
            // audio
            case audioPID:
                if(pus === 1) {
                    if(audioData && audioData.length > 0) {
                        var result = this.parsePES(audioData);
                        if(result) {
                            result.type = 'audio';
                            callback(result);
                            frameCount++;
                        }
                    }
                    audioData = [];
                }
                if(audioData) {
                    audioData.push(buf.subarray(offset, i + 188));
                }
                break;
            // avc
            case avcPID:
                if(pus === 1) {
                    if(avcData && avcData.length > 0) {
                        var result = this.parsePES(avcData);
                        if(result) {
                            result.type = 'video';
                            callback(result);
                        }
                    }
                    avcData = [];
                }
                if(avcData) {
                    avcData.push(buf.subarray(offset, i + 188));
                }
                break;
        }
    }
    if(audioData && audioData.length > 0) {
        var result = this.parsePES(audioData);
        if(result) {
            result.type = 'audio';
            callback(result);
        }
    }
    if(avcData && avcData.length > 0) {
        var result = this.parsePES(avcData);
        if(result) {
            result.type = 'video';
            callback(result);
            frameCount++;
        }
    }
    return frameCount;
};

TSDemuxer.prototype.parsePAT = function(buf, offset) {
    // parse the first PMT entry
    return (buf[offset + 10] & 0x1f) << 8 | buf[offset + 11];
};

TSDemuxer.prototype.parsePMT = function(buf, offset) {
    var result = {
        audioPID: -1,
        avcPID: -1
    };
    // section length
    var secLen = (buf[offset + 1] & 0x0f) << 8 | buf[offset + 2];
    var offsetEnd = offset + 3 + secLen - 4;
    // program info length
    var progInfoLen = (buf[offset + 10] & 0x0f) << 8 | buf[offset + 11];
    offset += 12 + progInfoLen;
    while(offset < offsetEnd) {
        var pid = (buf[offset + 1] & 0x1f) << 8 | buf[offset + 2];
        switch(buf[offset]) {
            // ISO/IEC 13818-7 ADTS AAC (MPEG-2 lower bit-rate audio)
            case 0x0f:
                if(result.audioPID === -1) {
                    result.audioPID = pid;
                }
                break;
            case 0x24:
                if(result.avcPID === -1) {
                    result.avcPID = pid;
                }
                break;
        }
        offset += ((buf[offset + 3] & 0x0f) << 8 | buf[offset + 4]) + 5;
    }
    return result;
};

TSDemuxer.prototype.parsePES = function(list) {
    if(!list || list.length === 0) {
        return null;
    }
    var pes0 = list[0];
    // packet start code prefix
    var prefix = pes0[0] << 16 | pes0[1] << 8 | pes0[2];
    if(prefix !== 1) {
        return null;
    }
    var pts;
    var dts;
    // 7 flags
    var flags = pes0[7];
    if(flags & 0x80) {
        pts = ((pes0[9] & 0x0e) * 536870912) +
              ((pes0[10] & 0xff) * 4194304) +
              ((pes0[11] & 0xfe) * 16384) +
              ((pes0[12] & 0xff) * 128) +
              ((pes0[13] & 0xfe) >> 1);
    }
    if(flags & 0x40) {
        dts = ((pes0[14] & 0x0e) * 536870912) +
              ((pes0[15] & 0xff) * 4194304) +
              ((pes0[16] & 0xfe) * 16384) +
              ((pes0[17] & 0xff) * 128) +
              ((pes0[18] & 0xfe) >> 1);
    }
    var result = {
        pts: pts,
        dts: dts
    };
    // PES header data length
    var hdrLen = pes0[8];
    // PES packet payload
    var payload = pes0.subarray(9 + hdrLen);
    // elementary stream
    var es = payload;
    for(var i = 1; i < list.length; i++) {
        var d = new Uint8Array(es.length + list[i].length);
        d.set(es);
        d.set(list[i], es.length);
        es = d;
    }
    result.es = es;
    return result;
};

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
